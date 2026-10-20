'use client';

// / — until the file browser exists (P0.3), this routes: unauthed → /sign-in,
// authed → placeholder hub with the settings link (where connect lives).

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/client/auth-context';

export default function Home() {
  const router = useRouter();
  const { user, loading, signOutUser } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace('/sign-in');
  }, [loading, user, router]);

  if (loading || !user) {
    return <main className="flex min-h-dvh items-center justify-center text-sm text-zinc-500">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">DriveThrough</h1>
        <button
          type="button"
          onClick={() => void signOutUser()}
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Sign out
        </button>
      </header>

      <p className="mt-2 text-sm text-zinc-500">Signed in as {user.email}</p>

      <div className="mt-6 rounded-[var(--radius-surface)] border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-500">
          The file browser lands in P0.3. For now you can manage storage accounts:
        </p>
        <Link
          href="/settings"
          className="mt-3 inline-flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
        >
          Connect a drive →
        </Link>
      </div>
    </main>
  );
}
