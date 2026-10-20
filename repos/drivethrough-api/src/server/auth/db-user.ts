// requireDbUser — verify bearer token AND resolve our users.id (flow.md §2: upsert keyed by
// firebase_uid on first authenticated call). Every protected route uses this, not bare requireAuth.

import { eq } from 'drizzle-orm';
import { requireAuth, type AuthedUser } from './verify';
import { getDb } from '../db/client';
import { users } from '../db/schema';

export interface DbUser extends AuthedUser {
  userId: string; // our users.id — FK target for accounts/files/uploads
}

/** Verify the ID token, then get-or-create the users row. Returns both identities. */
export async function requireDbUser(req: Request): Promise<DbUser> {
  const authed = await requireAuth(req);
  const db = getDb();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.firebaseUid, authed.firebaseUid))
    .limit(1);

  if (existing) return { ...authed, userId: existing.id };

  // first call ever for this Firebase user → create the row (G1: single insert, retry-safe via unique)
  const [created] = await db
    .insert(users)
    .values({
      firebaseUid: authed.firebaseUid,
      email: authed.email,
      name: authed.name ?? null,
      avatarUrl: authed.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: users.firebaseUid, // concurrent first-requests race → one wins, other updates
      set: { email: authed.email, name: authed.name ?? null, avatarUrl: authed.avatarUrl ?? null },
    })
    .returning({ id: users.id });

  return { ...authed, userId: created!.id };
}
