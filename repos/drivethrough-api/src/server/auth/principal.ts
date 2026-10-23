// Dual-auth principal (P0.4): one guard for /api/v1 that accepts EITHER a Firebase session
// bearer (app traffic) or an `dtk_…` API key (external scripts). The v1 routes additionally
// REQUIRE kind==='api_key' and the `uploads:write` scope — sessions are rejected there so
// the public contract is unambiguously key-authenticated (flow.md §9).

import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { authenticateApiKey } from '../keys/key-service';
import { requireDbUser } from './db-user';

export interface Principal {
  userId: string;
  kind: 'session' | 'api_key';
  keyId?: string;
  scopes?: string[];
}

/** Parse `Authorization: Bearer <token>` and resolve it to a Principal.
 *  `scope` (when given) is enforced for API keys; sessions carry implicit full access. */
export async function requirePrincipal(req: Request, opts?: { scope?: string }): Promise<Principal> {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Missing bearer token');
  }
  if (token.startsWith('dtk_')) {
    const key = await authenticateApiKey(token);
    if (opts?.scope && !key.scopes.includes(opts.scope)) {
      throw new AppError(ErrorCodes.FORBIDDEN, `API key lacks scope "${opts.scope}"`);
    }
    return { userId: key.userId, kind: 'api_key', keyId: key.keyId, scopes: key.scopes };
  }
  const dbUser = await requireDbUser(req);
  return { userId: dbUser.userId, kind: 'session' };
}

/** v1 is key-authenticated by contract — a session token gets an honest 401, not a 500. */
export async function requireApiKey(req: Request, opts?: { scope?: string }): Promise<Principal & { kind: 'api_key'; keyId: string }> {
  const principal = await requirePrincipal(req, opts);
  if (principal.kind !== 'api_key') {
    throw new AppError(
      ErrorCodes.UNAUTHENTICATED,
      'This endpoint requires an API key (Authorization: Bearer dtk_…) — create one in the API Keys view'
    );
  }
  return { ...principal, kind: 'api_key', keyId: principal.keyId! };
}
