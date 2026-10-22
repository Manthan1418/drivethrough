'use client';

// /sign-in — the retro world starts at the log-on dialog: a Win98 window on the teal
// desktop (design.md §5.1). Google popup + email/password (sign-in / sign-up toggle).

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/client/auth-context';
import { RetroButton, RetroInput } from '@/components/retro/controls';
import { RetroWindow } from '@/components/retro/window';
import { IconAlert } from '@/components/retro/icons';

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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4">
      {/* desktop flourish */}
      <p className="select-none text-[13px] font-bold tracking-wide text-white/80 drop-shadow-[1px_1px_0_rgba(0,0,0,0.35)]">
        ◆ DriveThrough
      </p>

      <RetroWindow title="DriveThrough — Log On" draggable className="w-[360px] max-w-full">
        <div className="space-y-3 p-1">
          <p className="text-[12px] text-ink-soft">
            {mode === 'signin' ? 'Sign in to your drives' : 'Create your account'}
          </p>

          <RetroButton className="w-full" disabled={busy} onClick={() => void run(signInWithGoogle)}>
            <GoogleG /> Continue with Google
          </RetroButton>

          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="bevel-thin-pressed h-px flex-1" /> or <span className="bevel-thin-pressed h-px flex-1" />
          </div>

          <form onSubmit={onSubmit} className="space-y-2">
            {mode === 'signup' && (
              <label className="block">
                <span className="mb-1 block text-[12px] font-bold">Name</span>
                <RetroInput placeholder="Optional" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-[12px] font-bold">E-mail</span>
              <RetroInput
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-bold">Password</span>
              <RetroInput
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
            </label>

            {error && (
              <p role="alert" className="bevel-thin-raised flex items-start gap-2 bg-[#f8e6e6] p-2 text-[12px] text-danger">
                <IconAlert size={14} /> {error}
              </p>
            )}

            <RetroButton variant="primary" type="submit" className="w-full" disabled={busy}>
              {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </RetroButton>
          </form>

          <p className="pt-1 text-center text-[12px] text-ink-soft">
            {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
            <button
              type="button"
              className="font-bold text-titlebar underline"
              onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); }}
            >
              {mode === 'signin' ? 'Create account' : 'Sign in'}
            </button>
          </p>
        </div>
      </RetroWindow>

      <p className="select-none text-center text-[11px] text-white/70">
        every drive you own · one window
      </p>
    </main>
  );
}

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
