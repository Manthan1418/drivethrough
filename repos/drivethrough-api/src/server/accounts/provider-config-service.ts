// Provider-config use-cases — 9Drive parity (their /system/google-config + provider-configs
// module): the deployment owner enters the app's Google OAuth client credentials in the
// Settings UI; we AES-256-GCM them into Neon (AAD = row id) instead of env vars. The client
// secret is WRITE-ONLY over the wire — only a hasSecret flag ever leaves the server.
// Resolution order for the connect/refresh flows: DB row (in-app form) > GOOGLE_* env (dev).

import { eq } from 'drizzle-orm';
import { ErrorCodes, type SaveGoogleConfigRequest } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { providerConfigs } from '../db/schema';
import { encryptSecret, decryptSecret } from '../crypto/vault';
import { envGoogleConfig, type OAuthConfig } from '../providers/google-oauth';

export interface GoogleConfigStatusResult {
  exists: boolean; // would the connect flow work right now?
  clientId: string; // public half — safe to echo (it rides in the consent URL anyway)
  redirectUri: string;
  hasSecret: boolean; // secret stored? (never the secret itself)
  defaultRedirectUri: string; // suggested value for the form
}

/** Suggested redirect URI: explicit env wins (local dev); on Vercel, derive from VERCEL_URL. */
function defaultRedirectUri(): string {
  const envUri = process.env.GOOGLE_REDIRECT_URI;
  if (envUri) return envUri;
  const host = process.env.VERCEL_URL; // injected per deployment, host without scheme
  return host ? `https://${host}/api/accounts/google/callback` : '';
}

async function findRow() {
  const db = getDb();
  const rows = await db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.provider, 'google_drive'))
    .limit(1);
  return rows[0] ?? null;
}

/** Effective config: DB row (in-app Settings form) > env fallback. null = nothing configured. */
export async function resolveGoogleOAuthConfig(): Promise<OAuthConfig | null> {
  const row = await findRow();
  if (row?.clientIdEnc && row.clientSecretEnc) {
    return {
      clientId: decryptSecret(row.clientIdEnc, row.id),
      clientSecret: decryptSecret(row.clientSecretEnc, row.id),
      redirectUri: row.redirectUri,
    };
  }
  return envGoogleConfig();
}

export async function getGoogleConfigStatus(): Promise<GoogleConfigStatusResult> {
  const row = await findRow();
  const fromDb = !!(row?.clientIdEnc && row.clientSecretEnc);
  const resolved = await resolveGoogleOAuthConfig();
  return {
    exists: resolved !== null,
    clientId: fromDb && row ? decryptSecret(row.clientIdEnc!, row.id) : (resolved?.clientId ?? ''),
    redirectUri: fromDb && row ? row.redirectUri : (resolved?.redirectUri ?? ''),
    hasSecret: resolved !== null,
    defaultRedirectUri: defaultRedirectUri(),
  };
}

/** Validate raw POST input against the contracts shape, with our error taxonomy (flow.md §9). */
export function parseGoogleConfigInput(raw: unknown): SaveGoogleConfigRequest {
  // manual checks instead of safeParse().error.issues — stable {code,message}, no zod internals
  const obj = raw as { clientId?: unknown; clientSecret?: unknown; redirectUri?: unknown } | null;
  if (!obj || typeof obj.clientId !== 'string' || obj.clientId.trim().length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'clientId is required');
  }
  if (obj.clientSecret !== undefined && (typeof obj.clientSecret !== 'string' || obj.clientSecret.trim().length === 0)) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'clientSecret must be a non-empty string when provided');
  }
  if (typeof obj.redirectUri !== 'string') {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'redirectUri is required');
  }
  try {
    const u = new URL(obj.redirectUri);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'redirectUri must be a valid http(s) URL');
  }
  return {
    clientId: obj.clientId.trim(),
    ...(typeof obj.clientSecret === 'string' ? { clientSecret: obj.clientSecret.trim() } : {}),
    redirectUri: obj.redirectUri.trim(),
  };
}

/** Upsert the config. `clientSecret` omitted ⇒ keep the stored secret (9Drive's write-only pattern). */
export async function saveGoogleConfig(raw: unknown): Promise<{ hasSecret: boolean; redirectUri: string }> {
  const input = parseGoogleConfigInput(raw);
  const row = await findRow();
  const db = getDb();

  if (row) {
    const keepSecret = input.clientSecret ? encryptSecret(input.clientSecret, row.id) : row.clientSecretEnc;
    await db
      .update(providerConfigs)
      .set({
        clientIdEnc: encryptSecret(input.clientId, row.id),
        clientSecretEnc: keepSecret,
        redirectUri: input.redirectUri,
        updatedAt: new Date(),
      })
      .where(eq(providerConfigs.id, row.id));
    return { hasSecret: !!keepSecret, redirectUri: input.redirectUri };
  }

  // new row: insert without secrets first — AAD must be the row id (G1: no plaintext at rest,
  // same two-step pattern as the accounts insert)
  const inserted = await db
    .insert(providerConfigs)
    .values({ provider: 'google_drive', redirectUri: input.redirectUri })
    .returning({ id: providerConfigs.id });
  const id = inserted[0]!.id;
  await db
    .update(providerConfigs)
    .set({
      clientIdEnc: encryptSecret(input.clientId, id),
      clientSecretEnc: input.clientSecret ? encryptSecret(input.clientSecret, id) : null,
    })
    .where(eq(providerConfigs.id, id));
  return { hasSecret: !!input.clientSecret, redirectUri: input.redirectUri };
}
