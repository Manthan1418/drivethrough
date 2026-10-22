// Google Drive OAuth + Drive REST primitives via raw fetch (tech.md §5 — avoid `googleapis` bundle).
// Covers the connect-a-account flow (flow.md §3): consent URL, code exchange, root folder, quota.
// No `any` in this path (AGENTS.md).

import { createHash, randomBytes } from 'node:crypto';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError, safeDetail } from '../errors';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive', // full drive: file manage + permissions for shares (reader-only)
].join(' ');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// Missing OAuth config is a SERVER SETUP gap, not an internal error: surface the stable
// SERVICE_NOT_CONFIGURED (503, message exposed) so the UI can say exactly what's missing
// instead of a raw 500 (design.md §6; caught live 2026-10-20). Config comes from the
// in-app Settings form (provider_configs, 9Drive parity) with the GOOGLE_* env vars as a
// local-dev fallback. No secrets in messages — var names only.

/** Public shape of the app's Google OAuth client credentials. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function notConfigured(varName: string): AppError {
  return new AppError(
    ErrorCodes.SERVICE_NOT_CONFIGURED,
    `Google Drive connect isn't configured on this server yet (missing ${varName} — GCP OAuth client not set up)`,
    503,
    true
  );
}

/** The stable "nowhere to get credentials from" error — points at the in-app form first. */
export function googleNotConfigured(): AppError {
  return new AppError(
    ErrorCodes.SERVICE_NOT_CONFIGURED,
    "Google Drive connect isn't configured on this server yet — save your Google API credentials in Settings (or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI env for local dev)",
    503,
    true
  );
}

/** Env fallback: null unless ALL THREE vars exist (incomplete env must not half-work). */
export function envGoogleConfig(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** Env-or-throw — used only when no config object was passed in (dev/test path). */
function envConfig(): OAuthConfig {
  if (!process.env.GOOGLE_CLIENT_ID) throw notConfigured('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET) throw notConfigured('GOOGLE_CLIENT_SECRET');
  if (!process.env.GOOGLE_REDIRECT_URI) throw notConfigured('GOOGLE_REDIRECT_URI');
  return envGoogleConfig()!;
}

// ---- PKCE (RFC 7636, S256) — Google supports it for web clients at no setup cost ----
// The verifier stays in the single-use oauth_states row; only the challenge goes to Google.
// Binds the authorization code to THIS flow (code-interception defense-in-depth). 9Drive
// parity minus this hardening — theirs is a plain state token.

export interface PkcePair {
  verifier: string; // secret half — sent back verbatim at the token exchange
  challenge: string; // public half — goes in the consent URL
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Build the Google consent URL. `state` is the single-use CSRF token (hashed in DB by caller).
 *  `cfg` is the resolved OAuth client config (Settings form > env); omitted ⇒ env-only. */
export function buildConsentUrl(state: string, codeChallenge: string, cfg?: OAuthConfig): string {
  const c = cfg ?? envConfig();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline', // get a refresh_token
    prompt: 'consent', // force consent screen so we always receive a refresh token
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null; // Google only returns refresh_token on first consent (hence prompt=consent)
  expiresAt: number; // epoch ms
  scope?: string;
}

/** Pure builder (unit-testable, no network): authorization-code token request incl. PKCE verifier. */
export function tokenRequestBody(code: string, codeVerifier?: string, cfg?: OAuthConfig): URLSearchParams {
  const c = cfg ?? envConfig();
  const body = new URLSearchParams({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
    grant_type: 'authorization_code',
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier); // PKCE: proof of the S256 challenge
  return body;
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCode(code: string, codeVerifier: string, cfg?: OAuthConfig): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(code, codeVerifier, cfg),
  });
  if (!res.ok) {
    // Surface Google's public error name/description — the step+status used to be swallowed
    // with no log anywhere (caught live 2026-10-22). safeDetail filters the external text.
    const body = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
    const ext = [body?.error, body?.error_description].filter(Boolean).join(' — ');
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      safeDetail(`Token exchange failed (${res.status})${ext ? `: ${ext}` : ''}`)
    );
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
export async function refreshAccessToken(refreshToken: string, cfg?: OAuthConfig): Promise<TokenSet> {
  const c = cfg ?? envConfig();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
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
  if (!created.ok) {
    const body = (await created.json().catch(() => null)) as { error?: { message?: string } } | null;
    const ext = body?.error?.message ?? '';
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      safeDetail(`Root folder create failed (${created.status})${ext ? `: ${ext}` : ''}`)
    );
  }
  const { id } = (await created.json()) as { id: string };
  return id;
}

/**
 * about.get with storageQuota + user: quota AND the authorizing user's identity in ONE call.
 * `permissionId` is Google's stable per-user id — the account identity key (9Drive keys on
 * their equivalent; email is display-only and can change). total=null when unlimited (Workspace).
 */
export interface DriveAbout {
  total: bigint | null;
  used: bigint;
  available: bigint | null;
  permissionId: string | null;
  email: string | null;
  displayName: string | null;
}

export async function fetchAbout(accessToken: string): Promise<DriveAbout> {
  const res = await driveFetch(accessToken, '/about?fields=storageQuota,user');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const ext = body?.error?.message ?? '';
    throw new AppError(
      ErrorCodes.PROVIDER_ERROR,
      safeDetail(`Quota fetch failed (${res.status})${ext ? `: ${ext}` : ''}`)
    );
  }
  const { storageQuota, user } = (await res.json()) as {
    storageQuota?: { usage?: string; limit?: string };
    user?: { permissionId?: string; emailAddress?: string; displayName?: string };
  };
  const used = BigInt(storageQuota?.usage ?? '0');
  const limit = storageQuota?.limit;
  const total = limit !== undefined ? BigInt(limit) : null;
  return {
    total,
    used,
    available: total !== null ? total - used : null,
    permissionId: user?.permissionId ?? null,
    email: user?.emailAddress ?? null,
    displayName: user?.displayName ?? null,
  };
}
