// Google Drive OAuth + Drive REST primitives via raw fetch (tech.md §5 — avoid `googleapis` bundle).
// Covers the connect-a-account flow (flow.md §3): consent URL, code exchange, root folder, quota.
// No `any` in this path (AGENTS.md).

import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive', // full drive: file manage + permissions for shares (reader-only)
].join(' ');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// Missing OAuth env is a SERVER SETUP gap, not an internal error: surface the stable
// SERVICE_NOT_CONFIGURED (503, message exposed) so the UI can say exactly what's missing
// instead of a raw 500 (design.md §6; caught live 2026-10-20). Values come from the GCP
// OAuth client → .env (local) / Vercel env (prod). No secrets in the message — var names only.
function notConfigured(varName: string): AppError {
  return new AppError(
    ErrorCodes.SERVICE_NOT_CONFIGURED,
    `Google Drive connect isn't configured on this server yet (missing ${varName} — GCP OAuth client not set up)`,
    503,
    true
  );
}
function clientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw notConfigured('GOOGLE_CLIENT_ID');
  return id;
}
function clientSecret(): string {
  const s = process.env.GOOGLE_CLIENT_SECRET;
  if (!s) throw notConfigured('GOOGLE_CLIENT_SECRET');
  return s;
}
function redirectUri(): string {
  const u = process.env.GOOGLE_REDIRECT_URI;
  if (!u) throw notConfigured('GOOGLE_REDIRECT_URI');
  return u;
}

/** Build the Google consent URL. `state` is the single-use CSRF token (hashed in DB by caller). */
export function buildConsentUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline', // get a refresh_token
    prompt: 'consent', // force consent screen so we always receive a refresh token
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null; // Google only returns refresh_token on first consent (hence prompt=consent)
  expiresAt: number; // epoch ms
  scope?: string;
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCode(code: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw new AppError(ErrorCodes.PROVIDER_ERROR, `Token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

/** Refresh an access token using the stored refresh_token. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // 400/401 here = refresh token revoked/deleted → caller marks account needs_reauth (G8)
    throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, `Token refresh failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function driveFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Drive token rejected');
  if (res.status === 429) throw new AppError(ErrorCodes.PROVIDER_RATE_LIMITED, 'Drive rate limited');
  return res;
}

/**
 * Ensure a single app root folder named "drivethrough" exists; return its id.
 * Idempotent: reuse the existing one if found. All physical objects live beneath it.
 */
export async function ensureRootFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    "name = 'drivethrough' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  );
  const found = await driveFetch(
    accessToken,
    `/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=1`
  );
  if (found.ok) {
    const list = (await found.json()) as { files: { id: string }[] };
    if (list.files[0]) return list.files[0].id;
  }
  const created = await driveFetch(accessToken, '/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'drivethrough',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!created.ok) throw new AppError(ErrorCodes.PROVIDER_ERROR, `Root folder create failed (${created.status})`);
  const { id } = (await created.json()) as { id: string };
  return id;
}

/** Fetch account storage quota (about?fields=storageQuota). total=null when unlimited (Workspace). */
export async function fetchQuota(accessToken: string): Promise<{
  total: bigint | null;
  used: bigint;
  available: bigint | null;
}> {
  const res = await driveFetch(accessToken, '/about?fields=storageQuota');
  if (!res.ok) throw new AppError(ErrorCodes.PROVIDER_ERROR, `Quota fetch failed (${res.status})`);
  const { storageQuota } = (await res.json()) as {
    storageQuota?: { usage?: string; limit?: string };
  };
  const used = BigInt(storageQuota?.usage ?? '0');
  const limit = storageQuota?.limit;
  const total = limit !== undefined ? BigInt(limit) : null;
  return { total, used, available: total !== null ? total - used : null };
}
