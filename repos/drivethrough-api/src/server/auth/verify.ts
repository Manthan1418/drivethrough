// Firebase ID-token verification guard (bearer-only, cross-origin) — tech.md §8, spike S5.
// Verifies Authorization: Bearer <idToken> on every protected route; maps firebase_uid → users row.

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';

let app: App | null = null;
let auth: Auth | null = null;

function getFirebaseAuth(): Auth {
  if (auth) return auth;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) throw new Error('FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_JSON not set');

  if (getApps().length === 0) {
    app = initializeApp({
      credential: cert(JSON.parse(saJson) as Parameters<typeof cert>[0]),
      projectId,
    });
  } else {
    app = getApps()[0]!;
  }
  auth = getAuth(app);
  return auth;
}

export interface AuthedUser {
  firebaseUid: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

/** Extract + verify the bearer ID token. Throws AppError(UNAUTHENTICATED) on any failure. */
export async function requireAuth(req: Request, opts: { checkRevoked?: boolean } = {}): Promise<AuthedUser> {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Missing bearer token');
  }
  try {
    const decoded = await getFirebaseAuth().verifyIdToken(token, opts.checkRevoked ?? false);
    return {
      firebaseUid: decoded.uid,
      email: decoded.email ?? '',
      name: decoded.name ?? undefined,
      avatarUrl: decoded.picture ?? undefined,
    };
  } catch (err) {
    // distinguish revoked vs malformed/expired for better UX, but don't leak internals
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Invalid or expired token');
  }
}
