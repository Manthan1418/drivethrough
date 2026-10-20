'use client';

// /sign-in — public entry (design.md §5.1). Google popup + email/password (sign-in / sign-up toggle).
// Redirects to / once authenticated (RootRedirect decides where authed users land).

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/client/auth-context';

type Mode = 'signin' | 'signup';
// Firebase auth codes → plain messages (design.md §6 spirit: never dump raw codes)
const AUTH_MSG: Record<string, string> = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/user-not-found': 'No account with that email — switch to Sign up.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/email-already-in-use': 'Already registered — switch to Sign in.',
  'auth/weak-password': 'Password needs at least 6 characters.',
  'auth/invalid-email': 'That email looks wrong.',
  'auth/too-many-requests': 'Too many attempts — try again in a minute.',
  'auth/popup-blocked': 'Popup was blocked — allow popups for this site.',
};

export default function SignInPage() {
  const router = useRouter();
  const { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // already signed in → leave
  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [user, loading, router]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.replace('/');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setError(AUTH_MSG[code] ?? 'Sign-in failed — try again.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(() =>
      mode === 'signin' ? signInWithEmail(email, password) : signUpWithEmail(email, password, name || undefined)
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-[var(--radius-surface)] border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold">DriveThrough</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {mode === 'signin' ? 'Sign in to your drives' : 'Create your account'}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run(signInWithGoogle)}
          className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-zinc-300 bg-white text-sm font-medium hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-750"
        >
          <GoogleG />
          Continue with Google
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" /> or <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          {mode === 'signup' && (
            <input
              className="h-11 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm outline-none focus:border-[var(--color-accent)] dark:border-zinc-700"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          )}
          <input
            className="h-11 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm outline-none focus:border-[var(--color-accent)] dark:border-zinc-700"
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <input
            className="h-11 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm outline-none focus:border-[var(--color-accent)] dark:border-zinc-700"
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />

          {error && <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="h-11 w-full rounded-[var(--radius-control)] bg-[var(--color-accent)] text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-zinc-500">
          {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="text-[var(--color-accent)] hover:underline"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); }}
          >
            {mode === 'signin' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  );
}

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  );
}
